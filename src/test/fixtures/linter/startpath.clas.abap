CLASS zcl_fixture_startpath DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    DATA result_text TYPE string.
    " only the TEST handler fills it - "" on the first display
    DATA result_type TYPE string.
    DATA declared_type TYPE string VALUE `Information`.
    DATA seeded_type TYPE string.
    DATA computed_type TYPE string.
    DATA omitted_type TYPE string.
    DATA popup_type TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.

    METHODS model_init.
    METHODS view_display.
    METHODS popup_display.
    METHODS type_of
      IMPORTING
        ok            TYPE abap_bool
      RETURNING
        VALUE(result) TYPE string.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_fixture_startpath IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( `TEST` ).
      TRY.
          result_text = `ok`.
          result_type = `Success`.
        CATCH cx_root.
          result_type = `Error`.
      ENDTRY.
    ELSEIF client->check_on_event( `POPUP` ).
      popup_type = `Warning`.
      popup_display( ).
    ELSEIF client->check_on_event( `POPUP_CLOSE` ).
      client->popup_destroy( ).
    ENDIF.

  ENDMETHOD.


  METHOD model_init.

    seeded_type = `Success`.
    computed_type = type_of( abap_true ).

  ENDMETHOD.


  METHOD type_of.

    result = COND #( WHEN ok = abap_true THEN `Success` ELSE `Error` ).

  ENDMETHOD.


  METHOD view_display.

    DATA(page) = z2ui5_cl_ui5_view_builder=>factory( )->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->ele( `Page` ).

    page->tag( `MessageStrip`
        )->a( n = `text` v = client->_bind( result_text )
        )->a( n = `type` v = client->_bind( result_type ) ).
    page->tag( `MessageStrip`
        )->a( n = `type` v = client->_bind( declared_type ) ).
    page->tag( `MessageStrip`
        )->a( n = `type` v = client->_bind( seeded_type ) ).
    page->tag( `MessageStrip`
        )->a( n = `type` v = client->_bind( computed_type ) ).
    page->tag( `MessageStrip`
        )->a( n = `type` v = client->_bind( val = omitted_type omit_initial = abap_true ) ).
    page->tag( `Button`
        )->a( n = `text`  v = `Test`
        )->a( n = `press` v = client->_event( `TEST` ) ).
    page->tag( `Button`
        )->a( n = `text`  v = `Popup`
        )->a( n = `press` v = client->_event( `POPUP` ) ).

    client->view_display( page->stringify( ) ).

  ENDMETHOD.


  METHOD popup_display.

    DATA(popup) = z2ui5_cl_ui5_view_builder=>factory( )->ele( n = `FragmentDefinition` ns = `core`
        )->a( n = `xmlns`      v = `sap.m`
        )->a( n = `xmlns:core` v = `sap.ui.core`
        )->ele( `Dialog`
            )->a( n = `afterClose` v = client->_event( `POPUP_CLOSE` )
            )->tag( `MessageStrip`
                )->a( n = `type` v = client->_bind( popup_type ) ).

    client->popup_display( popup->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
