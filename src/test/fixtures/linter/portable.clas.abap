CLASS zcl_portable DEFINITION PUBLIC.
  " A portable app: every control, member, binding, wire and action below is
  " in the abap2UI5 protocol's portable profile v1 - portable-app reports
  " nothing here (test/review/portable.mjs)
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    TYPES:
      BEGIN OF ty_row,
        id       TYPE string,
        title    TYPE string,
        amount   TYPE p LENGTH 10 DECIMALS 2,
        currency TYPE string,
        selected TYPE abap_bool,
      END OF ty_row.

    DATA name     TYPE string.
    DATA quantity TYPE i.
    DATA created  TYPE d.
    DATA active   TYPE abap_bool.
    DATA rows     TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.

    METHODS display_view.
    METHODS display_popup.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_portable IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.

    IF client->check_on_init( ).
      display_view( ).
      RETURN.
    ENDIF.

    CASE client->get( )-event.
      WHEN `SAVE`.
        client->message_toast_display( |Saved { name }| ).
        client->follow_up_action( val = client->cs_event-set_focus arg = `nameInput` ).
      WHEN `ROW`.
        display_popup( ).
      WHEN `SEARCH`.
        client->message_box_display( text = name ).
      WHEN `CLOSE`.
        client->popup_destroy( ).
    ENDCASE.

  ENDMETHOD.


  METHOD display_view.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    DATA(page) = view->ele( n = `View` ns = `mvc`
        )->a( n = `displayBlock` v = `true`
        )->a( n = `height` v = `100%`
        )->a( n = `xmlns` v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->a( n = `xmlns:form` v = `sap.ui.layout.form`
        )->a( n = `xmlns:core` v = `sap.ui.core`
        )->ele( `Shell`
            )->ele( `Page`
                )->a( n = `title` v = `Portable`
                )->a( n = `showNavButton` v = `{= ${/QUANTITY} > 0 }`
                )->a( n = `navButtonPress` v = client->_event_nav_app_leave( ) ).

    page->ele( n = `SimpleForm` ns = `form`
        )->a( n = `editable` v = `true`
        )->ele( n = `content` ns = `form`
            )->tag( n = `Title` ns = `core`
                )->a( n = `text` v = `Header`
            )->tag( `Label`
                )->a( n = `text` v = `Name`
                )->a( n = `labelFor` v = `nameInput`
            )->tag( `Input`
                )->a( n = `id` v = `nameInput`
                )->a( n = `value` v = client->_bind( name )
                )->a( n = `valueState` v = `{= ${/NAME}.trim().length > 0 ? 'None' : 'Error' }`
                )->a( n = `submit` v = client->_event( val = `SEARCH` arg = `${$parameters>/value}` )
            )->tag( `Label`
                )->a( n = `text` v = `Quantity`
            )->tag( `StepInput`
                )->a( n = `value` v = client->_bind( quantity )
                )->a( n = `max` v = `{= Math.max(${/QUANTITY}, 10) }`
            )->tag( `Label`
                )->a( n = `text` v = `Created`
            )->tag( `DatePicker`
                )->a( n = `value` v = client->_bind( created )
                )->a( n = `valueFormat` v = `yyyyMMdd`
            )->tag( `Switch`
                )->a( n = `state` v = client->_bind( active )
                )->a( n = `visible` v = `{device>/system/desktop}` ).

    page->ele( `Table`
        )->a( n = `items` v = client->_bind( rows )
        )->a( n = `mode` v = `MultiSelect`
        )->ele( `columns`
            )->ele( `Column`
                )->tag( `Text`
                    )->a( n = `text` v = `Title`
            )->end(
            )->ele( `Column`
                )->tag( `Text`
                    )->a( n = `text` v = `Amount`
            )->end(
        )->end(
        )->ele( `items`
            )->ele( `ColumnListItem`
                )->a( n = `type` v = `Navigation`
                )->a( n = `selected` v = `{SELECTED}`
                )->a( n = `press` v = client->_event( val = `ROW` arg = `${ID}` )
                )->ele( `cells`
                    )->tag( `ObjectIdentifier`
                        )->a( n = `title` v = `{TITLE}`
                    )->tag( `ObjectNumber`
                        )->a( n = `number` v = `{parts:['AMOUNT','CURRENCY'], type:'sap.ui.model.type.Currency', formatOptions:{showMeasure:false}}`
                        )->a( n = `unit` v = `{CURRENCY}` ).

    page->ele( `footer`
        )->ele( `OverflowToolbar`
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text` v = `Save`
                )->a( n = `type` v = `Emphasized`
                )->a( n = `press` v = client->_event( `SAVE` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.


  METHOD display_popup.

    DATA(popup) = z2ui5_cl_ui5_view_builder=>factory( ).
    popup->ele( n = `FragmentDefinition` ns = `core`
        )->a( n = `xmlns` v = `sap.m`
        )->a( n = `xmlns:core` v = `sap.ui.core`
        )->ele( `Dialog`
            )->a( n = `title` v = `Row`
            )->a( n = `afterClose` v = client->_event( `CLOSE` )
            )->tag( `Text`
                )->a( n = `text` v = `{path:'/CREATED', formatter:'Formatter.DateAbapDateToDateObject'}`
            )->ele( `beginButton`
                )->tag( `Button`
                    )->a( n = `text` v = `Close`
                    )->a( n = `press` v = client->follow_up_action( client->cs_event-popup_close ) ).

    client->popup_display( popup->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
